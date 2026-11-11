import { auth } from '../api';
import { state, setState } from '../state';
import type { User } from '../types';
import { phaseTargetPresets } from '../../server/src/nutrition';
import { createMountedLifetime } from '../mounted-lifetime';

export function mountSettingsForms(root: HTMLElement): () => void {
  const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  const forms = [...root.querySelectorAll('#profile-form, #targets-form, #workout-targets-form, #password-form')];
  const lifetime = createMountedLifetime(root, {
    ownedNodes: [
      ...forms,
      ...forms.flatMap(form => [...form.querySelectorAll('input, button, #profile-msg, #targets-msg, #workout-targets-msg, #pw-msg')]),
      ...root.querySelectorAll('#phase-presets, #phase-presets button, #phase-presets-msg'),
    ],
    cleanup: () => {
      timers.forEach(timer => clearTimeout(timer));
      timers.clear();
    },
  });
  const { isLive } = lifetime;
  if (!isLive()) return lifetime.dispose;
  const find = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const input = (id: string) => find<HTMLInputElement>(id);

  function on(element: Element, type: string, handler: (event: Event) => void) {
    element.addEventListener(type, event => {
      if (isLive() && root.contains(element)) handler(event);
    }, { signal: lifetime.signal });
  }

  function showMessage(element: HTMLElement, text: string, type: 'success' | 'error') {
    if (!isLive()) return;
    clearTimeout(timers.get(element));
    element.textContent = text;
    element.className = type === 'success' ? 'form-success' : 'form-error';
    timers.set(element, setTimeout(() => {
      timers.delete(element);
      if (isLive()) element.classList.add('hidden');
    }, 3000));
  }

  async function saveProfile(data: Partial<User>, message: HTMLElement, success: string, options: {
    apply?: (user: User) => void;
    failure?: string;
  } = {}) {
    try {
      const { user } = await auth.updateProfile(data);
      // Persistence outlives the form session; application state still receives its result.
      setState({ user });
      if (!isLive()) return;
      options.apply?.(user);
      showMessage(message, success, 'success');
    } catch (err) {
      showMessage(message, err instanceof Error ? err.message : options.failure ?? 'Unable to save profile.', 'error');
    }
  }

  const name = input('s-name');
  const feet = input('s-height-ft');
  const inches = input('s-height-in');
  const profileMessage = find('profile-msg');
  on(find('profile-form'), 'submit', async event => {
    event.preventDefault();
    await saveProfile({
      firstName: name.value,
      heightInches: (parseInt(feet.value) || 5) * 12 + (parseInt(inches.value) || 0),
    }, profileMessage, 'Profile saved!');
  });

  const restInputs = {
    targetCalories: input('s-cal'), targetCarbsG: input('s-carbs'),
    targetProteinG: input('s-protein'), targetFatG: input('s-fat'),
  };
  const workoutInputs = {
    workoutTargetCalories: input('s-wcal'), workoutTargetCarbsG: input('s-wcarbs'),
    workoutTargetProteinG: input('s-wprotein'), workoutTargetFatG: input('s-wfat'),
  };
  for (const [form, message, success, inputs] of [
    ['targets-form', 'targets-msg', 'Targets saved!', restInputs],
    ['workout-targets-form', 'workout-targets-msg', 'Workout targets saved!', workoutInputs],
  ] as const) {
    const feedback = find(message);
    on(find(form), 'submit', async event => {
      event.preventDefault();
      const data = Object.fromEntries(Object.entries(inputs).map(([key, control]) => [key, parseInt(control.value)]));
      await saveProfile(data, feedback, success);
    });
  }

  const targetInputs = { ...restInputs, ...workoutInputs };
  const presetMessage = find('phase-presets-msg');
  const saveButtons = root.querySelectorAll<HTMLButtonElement>('#phase-presets button, #targets-form button, #workout-targets-form button');
  for (const phase of ['lean-gain', 'maintenance', 'mini-cut'] as const) {
    const button = find<HTMLButtonElement>(`phase-${phase}`);
    const label = button.textContent;
    on(button, 'click', async () => {
      const { rest, workout } = phaseTargetPresets(state.user!.currentWeightLbs, phase);
      saveButtons.forEach(control => { control.disabled = true; });
      try {
        await saveProfile({
          targetCalories: rest.calories, targetCarbsG: rest.carbsG,
          targetProteinG: rest.proteinG, targetFatG: rest.fatG,
          workoutTargetCalories: workout.calories, workoutTargetCarbsG: workout.carbsG,
          workoutTargetProteinG: workout.proteinG, workoutTargetFatG: workout.fatG,
        }, presetMessage, `${label} targets saved for rest and workout days!`, {
          failure: 'Unable to save phase targets.',
          apply: user => {
            for (const [key, control] of Object.entries(targetInputs)) {
              control.value = String(user[key as keyof typeof targetInputs]);
            }
          },
        });
      } finally {
        if (isLive()) saveButtons.forEach(control => { control.disabled = false; });
      }
    });
  }

  const passwordForm = root.querySelector<HTMLFormElement>('#password-form');
  if (passwordForm) {
    const currentPassword = input('s-current-pw');
    const newPassword = input('s-new-pw');
    const passwordMessage = find('pw-msg');
    on(passwordForm, 'submit', async event => {
      event.preventDefault();
      const current = currentPassword.value;
      const next = newPassword.value;
      try {
        await auth.changePassword(current, next);
        if (!isLive()) return;
        showMessage(passwordMessage, 'Password changed!', 'success');
        currentPassword.value = '';
        newPassword.value = '';
      } catch (err) {
        showMessage(passwordMessage, err instanceof Error ? err.message : 'Unable to change password.', 'error');
      }
    });
  }

  return lifetime.dispose;
}
